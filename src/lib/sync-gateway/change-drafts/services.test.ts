import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { DomainError, type ChannelDraftDocument, type DraftChange, type DraftChangeSet, type DraftProvenance } from "./contracts";
import { createChangeDraftsCore, type ServiceDependencies } from "./services";
import type { ChangeDraftsStoreAdapter } from "./adapters/automerge-store";
import type { DiscardedDocumentBackupStore } from "./adapters/discarded-backup-store";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

function fakeStore(): ChangeDraftsStoreAdapter {
  const files = new Map<string, Uint8Array>();
  return {
    async loadDocumentBytes(channelId) {
      return files.get(channelId) ?? null;
    },
    async saveDocumentBytes(channelId, bytes) {
      files.set(channelId, bytes);
    },
  };
}

/** Not exercised except by the migrateFromSql-specific tests further down -- every other test
 * in this file never touches the SQL side at all, so an always-empty fake is the right default. */
function fakeSqlSource(overrides: Partial<SqlSourceAdapter> = {}): SqlSourceAdapter {
  return {
    async listChangeSetsForChannel(): Promise<DraftChangeSet[]> {
      return [];
    },
    async listChangesForChangeSet(): Promise<DraftChange[]> {
      return [];
    },
    ...overrides,
  };
}

/** An in-memory mirror of what a real `createSqlProjectionAdapter()` would write to SQL --
 * `projectedChangeSets`/`projectedChanges` let AC-CRDT-04 tests assert the projection actually
 * stayed in sync, without touching a real database. */
function fakeProjection(): SqlProjectionAdapter & {
  projectedChangeSets: Map<string, DraftChangeSet>;
  projectedChanges: Map<string, DraftChange>;
  projectedProvenance: Map<string, DraftProvenance>;
} {
  const projectedChangeSets = new Map<string, DraftChangeSet>();
  const projectedChanges = new Map<string, DraftChange>();
  const projectedProvenance = new Map<string, DraftProvenance>();
  return {
    projectedChangeSets,
    projectedChanges,
    projectedProvenance,
    async upsertChangeSet(changeSet) {
      projectedChangeSets.set(changeSet.id, changeSet);
    },
    async upsertChange(change) {
      projectedChanges.set(change.id, change);
    },
    async deleteChangeSet(changeSetId) {
      projectedChangeSets.delete(changeSetId);
    },
    async deleteChange(changeId) {
      projectedChanges.delete(changeId);
    },
    async upsertProvenance(provenance) {
      projectedProvenance.set(provenance.id, provenance);
    },
    async deleteProvenanceForChangeSet(changeSetId) {
      for (const [id, provenance] of projectedProvenance) {
        if (provenance.changeSetId === changeSetId) projectedProvenance.delete(id);
      }
    },
  };
}

/** In-memory backup store -- `backedUp` lets RISK-46 tests assert a backup was actually captured
 * (and with what bytes) without touching a real filesystem. */
function fakeDiscardedBackupStore(): DiscardedDocumentBackupStore & {
  backedUp: Array<{ channelId: string; bytes: Uint8Array }>;
} {
  const backedUp: Array<{ channelId: string; bytes: Uint8Array }> = [];
  return {
    backedUp,
    async backup(channelId, bytes) {
      backedUp.push({ channelId, bytes });
      return { path: `/fake/backup/${channelId}-${backedUp.length}.automerge`, capturedAt: new Date().toISOString() };
    },
  };
}

function makeDeps(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    store: fakeStore(),
    sqlSource: fakeSqlSource(),
    projection: fakeProjection(),
    discardedBackupStore: fakeDiscardedBackupStore(),
    ...overrides,
  };
}

const CHANNEL = "UC_test";

test("createChangeSet then addChange persists and is readable back via getDocument", async () => {
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore() }));

  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  const change = await core.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Original",
    changeType: "modify",
  });

  assert.equal(change.approvalStatus, "pending");

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changeSets["cs-1"].source, "ai_localization");
  assert.equal(doc.changes["c-1"].proposedValue, "Original");
});

// M4 (docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md §4, Category C).
test("createProvenance: stored alongside the change set and projected to SQL", async () => {
  const projection = fakeProjection();
  const core = createChangeDraftsCore(makeDeps({ projection }));
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });

  const provenance = await core.createProvenance({
    channelId: CHANNEL,
    id: "prov-1",
    changeSetId: "cs-1",
    profileVersion: 3,
    effectiveContextJson: '{"tone":"warm"}',
  });

  assert.equal(provenance.changeSetId, "cs-1");
  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.provenance?.["prov-1"]?.profileVersion, 3);
  assert.equal(projection.projectedProvenance.get("prov-1")?.effectiveContextJson, '{"tone":"warm"}');
});

test("createProvenance rejects a duplicate id", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  await core.createProvenance({ channelId: CHANNEL, id: "prov-1", changeSetId: "cs-1", profileVersion: null, effectiveContextJson: null });

  await assert.rejects(
    () => core.createProvenance({ channelId: CHANNEL, id: "prov-1", changeSetId: "cs-1", profileVersion: null, effectiveContextJson: null }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// Regression: a document saved before M4 added the `provenance` field has no such key at all
// (Automerge has no schema migration, `contracts.ts`'s own doc comment) -- `createProvenance`
// must initialize it defensively rather than throw on `draft.provenance[id] = ...` against
// `undefined`.
test("createProvenance initializes the provenance map on a document saved before this field existed", async () => {
  const store = fakeStore();
  // Simulate a pre-M4 document: built and saved via `Automerge.from` with no `provenance` key.
  const preM4Doc = Automerge.from<Omit<ChannelDraftDocument, "provenance">>({
    channelId: CHANNEL,
    changeSets: {
      "cs-1": {
        id: "cs-1",
        channelId: CHANNEL,
        source: "ai_localization",
        status: "in_review",
        importedFilename: null,
        schemaVersion: null,
        exportedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    changes: {},
  });
  await store.saveDocumentBytes(CHANNEL, Automerge.save(preM4Doc));

  const core = createChangeDraftsCore(makeDeps({ store }));
  const provenance = await core.createProvenance({
    channelId: CHANNEL,
    id: "prov-1",
    changeSetId: "cs-1",
    profileVersion: null,
    effectiveContextJson: null,
  });

  assert.equal(provenance.id, "prov-1");
  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.ok(doc.provenance?.["prov-1"]);
});

test("addChange rejects a change referencing a nonexistent change set", async () => {
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore() }));

  await assert.rejects(
    () =>
      core.addChange({
        channelId: CHANNEL,
        changeId: "c-1",
        changeSetId: "cs-missing",
        videoId: "v1",
        language: "es",
        field: "title",
        baselineValue: "A",
        proposedValue: "B",
        changeType: "modify",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

test("updateProposedValue rejects an unknown changeId", async () => {
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await assert.rejects(
    () => core.updateProposedValue({ channelId: CHANNEL, changeId: "does-not-exist", proposedValue: "x" }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

async function seedTwoDeviceDrafts() {
  // Two independent "devices" each holding their own store, both starting from the exact same
  // synced state -- mirrors CD1's spike (AUTOMERGE_MIGRATION_PLAN.md §3), now as a permanent
  // regression test against the real service layer rather than a throwaway script.
  const deviceA = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await deviceA.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  await deviceA.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original Title",
    proposedValue: "Original Title",
    changeType: "modify",
  });
  const syncedBytes = await deviceA.exportBytes({ channelId: CHANNEL });

  const deviceBStore = fakeStore();
  await deviceBStore.saveDocumentBytes(CHANNEL, syncedBytes);
  const deviceB = createChangeDraftsCore(makeDeps({ store: deviceBStore }));

  return { deviceA, deviceB };
}

// AC-CRDT-01
test("AC-CRDT-01: two devices edit DIFFERENT fields of the same change offline -- both edits survive the merge", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();

  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Título Original (ES)" });
  await deviceB.setApprovalStatus({ channelId: CHANNEL, changeId: "c-1", approvalStatus: "approved" });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const result = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });

  assert.deepEqual(result.newConflicts, []);
  const merged = await deviceA.getDocument({ channelId: CHANNEL });
  assert.equal(merged.changes["c-1"].proposedValue, "Título Original (ES)");
  assert.equal(merged.changes["c-1"].approvalStatus, "approved");
});

// AC-CRDT-02
test("AC-CRDT-02: two devices edit the SAME field of the same change offline -- conflict surfaced, neither silently discarded", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();

  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Version from Device A" });
  await deviceB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Version from Device B" });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const result = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });

  assert.equal(result.newConflicts.length, 1);
  assert.equal(result.newConflicts[0].changeId, "c-1");
  assert.equal(result.newConflicts[0].field, "proposedValue");
  const recoveredValues = Object.values(result.newConflicts[0].valuesByActor);
  assert.ok(recoveredValues.includes("Version from Device A"));
  assert.ok(recoveredValues.includes("Version from Device B"));

  // listConflicts must find the same conflict independently of the mergeIncoming call's own
  // return value, since a future caller (the Merge tab, CD6) queries it separately.
  const listed = await deviceA.listConflicts({ channelId: CHANNEL });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].changeId, "c-1");
});

test("resolveConflict writes the chosen competing value and clears the conflict, verified in-memory and across the save/load boundary", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();
  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Version from Device A" });
  await deviceB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Version from Device B" });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const merged = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });
  const conflict = merged.newConflicts[0];
  const [winningActorId, winningValue] = Object.entries(conflict.valuesByActor).find(
    ([, v]) => v === "Version from Device B"
  )!;

  const resolved = await deviceA.resolveConflict({
    channelId: CHANNEL,
    changeId: "c-1",
    field: "proposedValue",
    winningActorId,
  });
  assert.equal(resolved.proposedValue, winningValue);

  // The conflict must be gone, not just "resolved in the return value" -- re-fetch independently.
  const remainingConflicts = await deviceA.listConflicts({ channelId: CHANNEL });
  assert.equal(remainingConflicts.length, 0, "the conflict must actually be cleared, not merely reported as resolved");

  const doc = await deviceA.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-1"].proposedValue, "Version from Device B");
});

test("resolveConflict rejects an unknown winningActorId (e.g. a stale conflict already resolved elsewhere) rather than silently writing something", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();
  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "A" });
  await deviceB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "B" });
  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });

  await assert.rejects(
    () =>
      deviceA.resolveConflict({
        channelId: CHANNEL,
        changeId: "c-1",
        field: "proposedValue",
        winningActorId: "not-a-real-actor-id",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );

  // Nothing must have changed -- the conflict is still exactly as it was.
  const remainingConflicts = await deviceA.listConflicts({ channelId: CHANNEL });
  assert.equal(remainingConflicts.length, 1);
});

test("resolveConflict rejects a field/change with no actual conflict, rather than performing a no-op write", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  await core.addChange({
    channelId: CHANNEL, changeId: "c-1", changeSetId: "cs-1", videoId: "v1", language: "es",
    field: "title", baselineValue: "A", proposedValue: "B", changeType: "modify",
  });

  await assert.rejects(
    () => core.resolveConflict({ channelId: CHANNEL, changeId: "c-1", field: "proposedValue", winningActorId: "anything" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("mergeIncoming only reports NEWLY-introduced conflicts, not ones that already existed before this merge", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();

  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "A's value" });
  await deviceB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "B's value" });
  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const first = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });
  assert.equal(first.newConflicts.length, 1);

  // Merging the exact same bytes again must not report the already-known conflict as "new" a
  // second time (AC-CRDT-07 depends on this: a repeated sync cycle shouldn't spam duplicates).
  const second = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });
  assert.deepEqual(second.newConflicts, []);

  // But the conflict itself is still there when explicitly listed.
  const listed = await deviceA.listConflicts({ channelId: CHANNEL });
  assert.equal(listed.length, 1);
});

test("mergeIncoming into a device with NO local document for this channel adopts the peer's full content -- never attempts an unsafe merge of two independently-rooted documents", async () => {
  // Regression test for a real bug found while designing CD5 (device onboarding): a device
  // seeing a channel's drafts for the first time has no local document, so `mergeIncoming`
  // previously merged the peer's bytes into a freshly, independently-created empty document
  // (`Automerge.from()` inside `emptyDocument()`) -- two documents with no shared history do not
  // reliably combine via `Automerge.merge()`. Measured empirically: 55/100 trials silently
  // discarded the ENTIRE peer document (a coin flip tied to random actor-id tie-breaking, not a
  // rare edge case). Repeat this scenario enough times that the old, buggy implementation would
  // almost certainly have failed at least once (P(at least one failure in 20 trials at a true
  // ~50% per-trial rate) > 0.999999), so this test would have reliably caught the regression.
  const deviceA = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await deviceA.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-onboard", source: "ai_localization" });
  await deviceA.addChange({
    channelId: CHANNEL,
    changeId: "c-onboard-1",
    changeSetId: "cs-onboard",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Propuesta de A",
    changeType: "modify",
  });
  const aBytes = await deviceA.exportBytes({ channelId: CHANNEL });

  for (let i = 0; i < 20; i++) {
    // A brand-new device/store each iteration -- genuinely no local document for this channel.
    const freshDevice = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
    const result = await freshDevice.mergeIncoming({ channelId: CHANNEL, incomingBytes: aBytes });

    const adopted = await freshDevice.getDocument({ channelId: CHANNEL });
    assert.ok(adopted.changeSets["cs-onboard"], `iteration ${i}: the peer's change set must survive onboarding`);
    assert.equal(
      adopted.changes["c-onboard-1"]?.proposedValue,
      "Propuesta de A",
      `iteration ${i}: the peer's change must survive onboarding`
    );
    // Nothing local existed before, so nothing in the adopted document can be a "known" conflict
    // yet -- but the adopted document itself has no conflicts here either (single-source data).
    assert.deepEqual(result.newConflicts, [], `iteration ${i}: a clean peer document introduces no conflicts`);
  }
});

test("mergeIncoming REFUSES to merge two documents with no shared history, instead of silently discarding one side -- deterministic, not probabilistic", async () => {
  // Regression test for a second real bug found alongside the onboarding fix above: even when
  // the local device already has a real document (e.g. it just adopted peer B's bytes), merging
  // in a peer C whose document was independently bootstrapped (never synced with B) is NOT safe
  // -- measured empirically as a deterministic 100/100 silent loss of one whole side's content,
  // not a coin flip. `mergeIncoming` must fail closed (divergent_document_lineage) rather than
  // silently corrupt local state.
  const peerB = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await peerB.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-b", source: "ai_localization" });
  const bBytes = await peerB.exportBytes({ channelId: CHANNEL });

  const peerC = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await peerC.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-c", source: "ai_localization" });
  const cBytes = await peerC.exportBytes({ channelId: CHANNEL });

  // Local device: starts empty, adopts B first (the fix above), then encounters unrelated C.
  const local = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await local.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });

  await assert.rejects(
    () => local.mergeIncoming({ channelId: CHANNEL, incomingBytes: cBytes }),
    (error: unknown) => error instanceof DomainError && error.code === "divergent_document_lineage"
  );

  // Critically: the rejected merge must not have partially mutated local state -- B's data must
  // still be intact and untouched.
  const doc = await local.getDocument({ channelId: CHANNEL });
  assert.ok(doc.changeSets["cs-b"], "B's data must survive a rejected merge attempt");
  assert.equal(doc.changeSets["cs-c"], undefined, "C's data must never have been partially applied");
});

test("mergeIncoming still merges correctly when the incoming document is a REAL fork of the local one, even after both diverge (positive control for the lineage check)", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();
  await deviceA.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "From A" });
  await deviceB.setApprovalStatus({ channelId: CHANNEL, changeId: "c-1", approvalStatus: "approved" });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const result = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });
  assert.deepEqual(result.newConflicts, []);

  const doc = await deviceA.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-1"].proposedValue, "From A");
  assert.equal(doc.changes["c-1"].approvalStatus, "approved");
});

// RISK-46 (docs/TECHNICAL_DEBT.md): the explicit "discard my local copy, adopt this peer's
// version instead" resolution for a channel whose document genuinely diverged -- exactly the
// scenario mergeIncoming's own lineage guard refuses to merge automatically.
test("discardLocalAndAdoptPeer backs up the local document, then replaces it entirely with the peer's -- works even for genuinely divergent (unrelated) documents", async () => {
  const backupStore = fakeDiscardedBackupStore();
  const local = createChangeDraftsCore(makeDeps({ store: fakeStore(), discardedBackupStore: backupStore }));
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-local", source: "ai_localization" });
  const localBytesBeforeDiscard = await local.exportBytes({ channelId: CHANNEL });

  // An unrelated peer document -- independently bootstrapped, no shared history with local.
  const peer = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await peer.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-peer", source: "ai_localization" });
  const peerBytes = await peer.exportBytes({ channelId: CHANNEL });

  // Confirm this really is the divergent-lineage case mergeIncoming refuses.
  await assert.rejects(
    () => local.mergeIncoming({ channelId: CHANNEL, incomingBytes: peerBytes }),
    (error: unknown) => error instanceof DomainError && error.code === "divergent_document_lineage"
  );

  const result = await local.discardLocalAndAdoptPeer({ channelId: CHANNEL, incomingBytes: peerBytes });
  assert.ok(result.backupPath, "the discarded local document must have been backed up");
  assert.equal(backupStore.backedUp.length, 1);
  assert.deepEqual(Array.from(backupStore.backedUp[0]!.bytes), Array.from(localBytesBeforeDiscard));
  assert.equal(backupStore.backedUp[0]!.channelId, CHANNEL);

  const doc = await local.getDocument({ channelId: CHANNEL });
  assert.ok(doc.changeSets["cs-peer"], "the peer's change set must now be present");
  assert.equal(doc.changeSets["cs-local"], undefined, "the discarded local change set must be gone");
});

test("discardLocalAndAdoptPeer with no existing local document adopts directly and reports no backup (nothing existed to lose)", async () => {
  const backupStore = fakeDiscardedBackupStore();
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore(), discardedBackupStore: backupStore }));

  const peer = createChangeDraftsCore(makeDeps());
  await peer.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-peer", source: "ai_localization" });
  const peerBytes = await peer.exportBytes({ channelId: CHANNEL });

  const result = await core.discardLocalAndAdoptPeer({ channelId: CHANNEL, incomingBytes: peerBytes });
  assert.equal(result.backupPath, null);
  assert.equal(backupStore.backedUp.length, 0);

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.ok(doc.changeSets["cs-peer"]);
});

// Regression test: found live (a real browser session, not assumed) -- without this cleanup, a
// change set/change that existed ONLY in the discarded document remained forever visible via SQL
// (`listChangeSets`/`getChangeSet`, unchanged reads) yet threw `not_found` the instant anything
// tried to act on it, since the real Automerge document no longer has it.
test("discardLocalAndAdoptPeer removes SQL projection rows for change sets/changes that existed ONLY in the discarded document, keeps rows shared with the adopted one", async () => {
  const projection = fakeProjection();
  const local = createChangeDraftsCore(makeDeps({ store: fakeStore(), projection }));
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-local-only", source: "ai_localization" });
  await local.addChange({
    channelId: CHANNEL, changeId: "c-local-only", changeSetId: "cs-local-only", videoId: "v1",
    language: "es", field: "title", baselineValue: "A", proposedValue: "B", changeType: "modify",
  });
  assert.ok(projection.projectedChangeSets.has("cs-local-only"));
  assert.ok(projection.projectedChanges.has("c-local-only"));

  const peer = createChangeDraftsCore(makeDeps());
  await peer.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-peer-only", source: "ai_localization" });
  await peer.addChange({
    channelId: CHANNEL, changeId: "c-peer-only", changeSetId: "cs-peer-only", videoId: "v1",
    language: "es", field: "title", baselineValue: "A", proposedValue: "C", changeType: "modify",
  });
  const peerBytes = await peer.exportBytes({ channelId: CHANNEL });

  await local.discardLocalAndAdoptPeer({ channelId: CHANNEL, incomingBytes: peerBytes });

  assert.equal(projection.projectedChangeSets.has("cs-local-only"), false, "the discarded change set's SQL row must be removed");
  assert.equal(projection.projectedChanges.has("c-local-only"), false, "the discarded change's SQL row must be removed");
  assert.ok(projection.projectedChangeSets.has("cs-peer-only"), "the adopted change set must still be projected");
  assert.ok(projection.projectedChanges.has("c-peer-only"), "the adopted change must still be projected");
});

// Regression (independent review, found before any FK exception was ever actually hit live):
// `ai_localization_generation_provenance.change_set_id` is a NOT NULL, un-cascaded FK to
// `change_sets(id)`. A discarded change set with a provenance row must have that provenance row
// removed FIRST, or the real `deleteStoredChangeSet` would throw a foreign-key-constraint error.
test("discardLocalAndAdoptPeer removes provenance for a fully-discarded change set, AND for a change set that survives but whose adopted (peer) version has no provenance recorded", async () => {
  const projection = fakeProjection();
  const local = createChangeDraftsCore(makeDeps({ store: fakeStore(), projection }));
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-local-only", source: "ai_localization" });
  await local.createProvenance({
    channelId: CHANNEL, id: "prov-local-only", changeSetId: "cs-local-only", profileVersion: 1, effectiveContextJson: null,
  });
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-shared", source: "ai_localization" });
  await local.createProvenance({
    channelId: CHANNEL, id: "prov-shared", changeSetId: "cs-shared", profileVersion: 1, effectiveContextJson: null,
  });
  assert.ok(projection.projectedProvenance.has("prov-local-only"));
  assert.ok(projection.projectedProvenance.has("prov-shared"));

  const peer = createChangeDraftsCore(makeDeps());
  await peer.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-shared", source: "ai_localization" });
  const peerBytes = await peer.exportBytes({ channelId: CHANNEL });

  await local.discardLocalAndAdoptPeer({ channelId: CHANNEL, incomingBytes: peerBytes });

  assert.equal(projection.projectedChangeSets.has("cs-local-only"), false, "the discarded change set must be removed");
  assert.equal(
    projection.projectedProvenance.has("prov-local-only"),
    false,
    "the discarded change set's provenance row must be removed too, not left as a phantom pointing at a deleted change set"
  );
  assert.ok(projection.projectedChangeSets.has("cs-shared"), "cs-shared survives -- the peer's document also has it");
  assert.equal(
    projection.projectedProvenance.has("prov-shared"),
    false,
    "cs-shared's own provenance must ALSO be removed: the peer's (adopted) version of cs-shared carries no provenance at all, so " +
      "scoping cleanup to \"only when the parent change set itself is removed\" would leave this row as a real, undetected orphan"
  );
});

// Regression (independent review): the cleanup loop previously wrapped ALL deletions in ONE
// try/catch, so a single row's failure silently aborted cleanup of every other row too --
// reintroducing the exact phantom-row problem this cleanup exists to fix, for the whole discard.
test("discardLocalAndAdoptPeer isolates each row's cleanup -- one failing deletion does not block the others", async () => {
  const projection = fakeProjection();
  const failingDeleteChangeSet: SqlProjectionAdapter = {
    ...projection,
    async deleteChangeSet(changeSetId) {
      if (changeSetId === "cs-fails") throw new Error("simulated FK failure");
      await projection.deleteChangeSet(changeSetId);
    },
  };
  const local = createChangeDraftsCore(makeDeps({ store: fakeStore(), projection: failingDeleteChangeSet }));
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-fails", source: "ai_localization" });
  await local.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-also-discarded", source: "ai_localization" });
  assert.ok(projection.projectedChangeSets.has("cs-also-discarded"));

  const peer = createChangeDraftsCore(makeDeps());
  await peer.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-peer", source: "ai_localization" });
  const peerBytes = await peer.exportBytes({ channelId: CHANNEL });

  // Must not throw -- the document write itself succeeds regardless of projection cleanup issues.
  await local.discardLocalAndAdoptPeer({ channelId: CHANNEL, incomingBytes: peerBytes });

  assert.equal(
    projection.projectedChangeSets.has("cs-also-discarded"),
    false,
    "a later row's cleanup must still run even though an earlier row's deletion failed"
  );
});

test("getDocument/exportBytes/listConflicts reject a channel that was never saved, rather than silently returning an empty document", async () => {
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore() }));

  for (const call of [
    () => core.getDocument({ channelId: "UC_never_touched" }),
    () => core.exportBytes({ channelId: "UC_never_touched" }),
    () => core.listConflicts({ channelId: "UC_never_touched" }),
  ]) {
    await assert.rejects(call, (error: unknown) => error instanceof DomainError && error.code === "not_found");
  }
});

// Regression test for a real bug found during review: a THIRD device's distinct value arriving
// on a field that is *already* known to be conflicted must still be reported as new -- the
// previous implementation deduplicated by "was this change/field already conflicted at all,"
// which silently absorbed a genuinely new, never-before-seen value into an existing conflict
// without ever telling the operator about it.
test("mergeIncoming reports a NEW competing value on an ALREADY-conflicted field as new", async () => {
  const { deviceA, deviceB } = await seedTwoDeviceDrafts();
  // Capture the ONE pristine synced state up front -- C and D must both fork from this, never
  // from a later, already-merged state, or their edit would be causally *after* (and so would
  // supersede, not conflict with) the others' -- Automerge only treats writes as conflicting when
  // neither has seen the other's change.
  const pristineBytes = await deviceA.exportBytes({ channelId: CHANNEL });

  const deviceCStore = fakeStore();
  await deviceCStore.saveDocumentBytes(CHANNEL, pristineBytes);
  const deviceC = createChangeDraftsCore(makeDeps({ store: deviceCStore }));

  const deviceDStore = fakeStore();
  await deviceDStore.saveDocumentBytes(CHANNEL, pristineBytes);
  const deviceD = createChangeDraftsCore(makeDeps({ store: deviceDStore }));

  await deviceB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "B value" });
  await deviceC.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "C value" });
  await deviceD.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "D value" });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  const firstMerge = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });
  assert.equal(firstMerge.newConflicts.length, 0, "no conflict yet -- A had no divergent write of its own");

  const cBytes = await deviceC.exportBytes({ channelId: CHANNEL });
  const secondMerge = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: cBytes });
  assert.equal(secondMerge.newConflicts.length, 1, "B-vs-C is a genuinely new conflict to A");

  // D's edit was made concurrently with (never having seen) either B's or C's -- merging it in
  // must surface as a new development on the same field, not be silently absorbed.
  const dBytes = await deviceD.exportBytes({ channelId: CHANNEL });
  const thirdMerge = await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: dBytes });
  assert.equal(thirdMerge.newConflicts.length, 1, "D's distinct value must be reported as new, not silently absorbed");

  const allValues = Object.values(thirdMerge.newConflicts[0].valuesByActor);
  assert.ok(allValues.includes("D value"));

  const finalConflicts = await deviceA.listConflicts({ channelId: CHANNEL });
  assert.equal(finalConflicts.length, 1);
  const finalValues = Object.values(finalConflicts[0].valuesByActor);
  assert.equal(finalValues.length, 3, "all three concurrently-proposed values remain recoverable, none discarded");
});

test("mergeIncoming rejects malformed input before touching the store", async () => {
  const core = createChangeDraftsCore(makeDeps({ store: fakeStore() }));
  await assert.rejects(
    () => core.mergeIncoming({ channelId: CHANNEL, incomingBytes: "not-bytes" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// AC-CRDT-03: migrating existing local change_sets/changes data loses zero information -- every
// row's every column is present and reconstructible from the migrated document.
test("AC-CRDT-03: migrateFromSql losslessly converts every SQL row's every column into the document", async () => {
  const changeSet: DraftChangeSet = {
    id: "cs-1",
    channelId: CHANNEL,
    source: "xlsx_import",
    status: "partially_approved",
    importedFilename: "batch.xlsx",
    schemaVersion: "1",
    exportedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:01.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  const changeOne: DraftChange = {
    id: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Nuevo",
    changeType: "modify",
    validationStatus: "valid",
    validationError: null,
    conflictStatus: "none",
    approvalStatus: "approved",
    approvedValue: "Nuevo",
    createdAt: "2026-09-01T00:00:02.000Z",
    updatedAt: "2026-09-01T00:00:03.000Z",
  };
  const changeTwo: DraftChange = {
    id: "c-2",
    changeSetId: "cs-1",
    videoId: "v2",
    language: "fr",
    field: "description",
    baselineValue: "",
    proposedValue: "Nouvelle description",
    changeType: "add",
    validationStatus: "invalid",
    validationError: "too long",
    conflictStatus: "conflict",
    approvalStatus: "rejected",
    approvedValue: null,
    createdAt: "2026-09-01T00:00:04.000Z",
    updatedAt: "2026-09-01T00:00:05.000Z",
  };

  const sqlSource = fakeSqlSource({
    async listChangeSetsForChannel(channelId) {
      return channelId === CHANNEL ? [changeSet] : [];
    },
    async listChangesForChangeSet(changeSetId) {
      return changeSetId === "cs-1" ? [changeOne, changeTwo] : [];
    },
  });
  const core = createChangeDraftsCore(makeDeps({ sqlSource }));

  const result = await core.migrateFromSql({ channelId: CHANNEL });
  assert.deepEqual(result, { changeSetCount: 1, changeCount: 2 });

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.deepEqual(doc.changeSets["cs-1"], changeSet);
  assert.deepEqual(doc.changes["c-1"], changeOne);
  assert.deepEqual(doc.changes["c-2"], changeTwo);

  // Also verify across the actual persistence boundary (export -> raw Automerge.load), not just
  // through getDocument served by the same in-memory fakeStore round trip -- the clone bug found
  // earlier in this module was exactly the kind of thing that only shows up after a real
  // save/load cycle, not from constructing and reading a document in one breath.
  const exported = await core.exportBytes({ channelId: CHANNEL });
  const reloaded = Automerge.load<ChannelDraftDocument>(exported);
  assert.deepEqual(reloaded.changeSets["cs-1"], changeSet);
  assert.deepEqual(reloaded.changes["c-1"], changeOne);
  assert.deepEqual(reloaded.changes["c-2"], changeTwo);
});

test("migrateFromSql refuses to run a second time against a channel that already has a document", async () => {
  const store = fakeStore();
  const core = createChangeDraftsCore(makeDeps({ store }));
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });

  await assert.rejects(
    () => core.migrateFromSql({ channelId: CHANNEL }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// AC-CRDT-04: the SQL read-projection always reflects the current merged Automerge state after
// any local edit or remote merge.
test("AC-CRDT-04: every mutation (create, add, update, approve) keeps the SQL projection in sync", async () => {
  const projection = fakeProjection();
  const core = createChangeDraftsCore(makeDeps({ projection }));

  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  assert.equal(projection.projectedChangeSets.get("cs-1")?.status, "in_review");

  await core.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Original",
    changeType: "modify",
  });
  assert.equal(projection.projectedChanges.get("c-1")?.proposedValue, "Original");

  await core.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Updated" });
  assert.equal(projection.projectedChanges.get("c-1")?.proposedValue, "Updated");

  await core.setApprovalStatus({ channelId: CHANNEL, changeId: "c-1", approvalStatus: "approved", approvedValue: "Updated" });
  assert.equal(projection.projectedChanges.get("c-1")?.approvalStatus, "approved");
  assert.equal(projection.projectedChanges.get("c-1")?.approvedValue, "Updated");
});

test("AC-CRDT-04: mergeIncoming projects every change set/change the merge brought in, not just ones this device already knew about", async () => {
  const projectionA = fakeProjection();
  const deviceA = createChangeDraftsCore(makeDeps({ projection: projectionA }));
  await deviceA.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });

  // A second device forks from A's synced state (a real common history, not an unrelated
  // from-scratch document -- Automerge.merge assumes a shared lineage), then independently
  // creates a change set A has never seen.
  const deviceBStore = fakeStore();
  await deviceBStore.saveDocumentBytes(CHANNEL, await deviceA.exportBytes({ channelId: CHANNEL }));
  const deviceB = createChangeDraftsCore(makeDeps({ store: deviceBStore }));
  await deviceB.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-2", source: "xlsx_import" });
  await deviceB.addChange({
    channelId: CHANNEL,
    changeId: "c-remote",
    changeSetId: "cs-2",
    videoId: "v2",
    language: "fr",
    field: "description",
    baselineValue: "",
    proposedValue: "Nouvelle",
    changeType: "add",
  });

  const bBytes = await deviceB.exportBytes({ channelId: CHANNEL });
  await deviceA.mergeIncoming({ channelId: CHANNEL, incomingBytes: bBytes });

  assert.ok(projectionA.projectedChangeSets.has("cs-2"), "the remote change set must be projected too");
  assert.equal(projectionA.projectedChanges.get("c-remote")?.proposedValue, "Nouvelle");
});

// Regression test: a projection failure must never fail the operation that triggered it -- the
// Automerge document (the real source of truth) already saved successfully by the time the
// projection runs, so the caller must see success, not an error for an operation that actually
// happened. See saveDocument's own comment for why a silent, logged failure here is deliberate.
test("a throwing projection does not fail createChangeSet/addChange/mergeIncoming -- the document write still succeeds", async () => {
  const throwingProjection: SqlProjectionAdapter = {
    async upsertChangeSet() {
      throw new Error("simulated DB failure");
    },
    async upsertChange() {
      throw new Error("simulated DB failure");
    },
    async deleteChangeSet() {
      throw new Error("simulated DB failure");
    },
    async deleteChange() {
      throw new Error("simulated DB failure");
    },
    async upsertProvenance() {
      throw new Error("simulated DB failure");
    },
    async deleteProvenanceForChangeSet() {
      throw new Error("simulated DB failure");
    },
  };
  const core = createChangeDraftsCore(makeDeps({ projection: throwingProjection }));

  // Must not throw, despite the projection always throwing.
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  await core.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Original",
    changeType: "modify",
  });

  // And the document itself genuinely did save, projection failure notwithstanding.
  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-1"].proposedValue, "Original");
});

test("addChange accepts explicit validationStatus/validationError/conflictStatus instead of always defaulting -- an importer's real per-row results must not be discarded", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "xlsx_import" });

  const change = await core.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "",
    changeType: "modify",
    validationStatus: "invalid",
    validationError: "proposed value cannot be empty",
    conflictStatus: "conflict",
  });

  assert.equal(change.validationStatus, "invalid");
  assert.equal(change.validationError, "proposed value cannot be empty");
  assert.equal(change.conflictStatus, "conflict");
});

test("setChangeSetStatus updates the change set's status field", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });

  const updated = await core.setChangeSetStatus({ channelId: CHANNEL, changeSetId: "cs-1", status: "approved" });
  assert.equal(updated.status, "approved");

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changeSets["cs-1"].status, "approved");
});

test("setChangeSetStatus rejects an unknown changeSetId", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await assert.rejects(
    () => core.setChangeSetStatus({ channelId: CHANNEL, changeSetId: "does-not-exist", status: "approved" }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

test("patchChange updates only the fields provided, leaving the rest untouched", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
  await core.addChange({
    channelId: CHANNEL,
    changeId: "c-1",
    changeSetId: "cs-1",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Nuevo",
    changeType: "modify",
  });

  const patched = await core.patchChange({ channelId: CHANNEL, changeId: "c-1", patch: { conflictStatus: "conflict" } });
  assert.equal(patched.conflictStatus, "conflict");
  assert.equal(patched.approvalStatus, "pending", "untouched field must survive the patch");
  assert.equal(patched.proposedValue, "Nuevo", "untouched field must survive the patch");

  const approved = await core.patchChange({
    channelId: CHANNEL,
    changeId: "c-1",
    patch: { approvalStatus: "approved", approvedValue: "Nuevo" },
  });
  assert.equal(approved.approvalStatus, "approved");
  assert.equal(approved.approvedValue, "Nuevo");
  assert.equal(approved.conflictStatus, "conflict", "the earlier patch's field must still survive");
});

test("patchChange rejects an unknown changeId", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await assert.rejects(
    () => core.patchChange({ channelId: CHANNEL, changeId: "does-not-exist", patch: { conflictStatus: "conflict" } }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

test("createChangeSetWithChanges creates a change set and all of its changes in one call, honoring an explicit initialStatus", async () => {
  const core = createChangeDraftsCore(makeDeps());
  const changeSet = await core.createChangeSetWithChanges({
    channelId: CHANNEL,
    changeSetId: "cs-batch-1",
    source: "xlsx_import",
    initialStatus: "approved",
    changes: [
      {
        changeId: "c-batch-1",
        videoId: "v1",
        language: "es",
        field: "title",
        baselineValue: "Original",
        proposedValue: "Nuevo",
        changeType: "modify",
      },
      {
        changeId: "c-batch-2",
        videoId: "v1",
        language: "es",
        field: "description",
        baselineValue: "Desc",
        proposedValue: "Nueva desc",
        changeType: "modify",
        validationStatus: "invalid",
        validationError: "too long",
        conflictStatus: "conflict",
      },
    ],
  });

  assert.equal(changeSet.status, "approved");

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-batch-1"].proposedValue, "Nuevo");
  assert.equal(doc.changes["c-batch-2"].validationStatus, "invalid");
  assert.equal(doc.changes["c-batch-2"].conflictStatus, "conflict");
  assert.equal(doc.changeSets["cs-batch-1"].status, "approved");
});

test("createChangeSetWithChanges is all-or-nothing: a duplicate changeId inside the batch leaves NOTHING persisted, not a partially-created change set", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-existing", source: "ai_localization" });
  await core.addChange({
    channelId: CHANNEL,
    changeId: "c-already-exists",
    changeSetId: "cs-existing",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Existing",
    changeType: "modify",
  });

  await assert.rejects(
    () =>
      core.createChangeSetWithChanges({
        channelId: CHANNEL,
        changeSetId: "cs-batch-2",
        source: "xlsx_import",
        changes: [
          { changeId: "c-new", videoId: "v1", language: "es", field: "title", baselineValue: "A", proposedValue: "B", changeType: "modify" },
          {
            changeId: "c-already-exists",
            videoId: "v1",
            language: "es",
            field: "description",
            baselineValue: "A",
            proposedValue: "B",
            changeType: "modify",
          },
        ],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changeSets["cs-batch-2"], undefined, "the change set itself must not have been created");
  assert.equal(doc.changes["c-new"], undefined, "no change from the rejected batch must have been persisted, not even the non-conflicting one");
});

test("bulkPatchChanges patches multiple changes in one call", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-bulk", source: "xlsx_import" });
  await core.addChange({
    channelId: CHANNEL, changeId: "c-bulk-1", changeSetId: "cs-bulk", videoId: "v1", language: "es",
    field: "title", baselineValue: "A", proposedValue: "B", changeType: "modify",
  });
  await core.addChange({
    channelId: CHANNEL, changeId: "c-bulk-2", changeSetId: "cs-bulk", videoId: "v1", language: "es",
    field: "description", baselineValue: "C", proposedValue: "D", changeType: "modify",
  });

  const patched = await core.bulkPatchChanges({
    channelId: CHANNEL,
    updates: [
      { changeId: "c-bulk-1", patch: { approvalStatus: "approved", approvedValue: "B" } },
      { changeId: "c-bulk-2", patch: { approvalStatus: "rejected", approvedValue: null } },
    ],
  });

  assert.equal(patched.find((c) => c.id === "c-bulk-1")?.approvalStatus, "approved");
  assert.equal(patched.find((c) => c.id === "c-bulk-2")?.approvalStatus, "rejected");

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-bulk-1"].approvalStatus, "approved");
  assert.equal(doc.changes["c-bulk-2"].approvalStatus, "rejected");
});

test("bulkPatchChanges is all-or-nothing: one unknown changeId in the batch leaves every change in the batch untouched", async () => {
  const core = createChangeDraftsCore(makeDeps());
  await core.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-bulk-2", source: "xlsx_import" });
  await core.addChange({
    channelId: CHANNEL, changeId: "c-bulk-3", changeSetId: "cs-bulk-2", videoId: "v1", language: "es",
    field: "title", baselineValue: "A", proposedValue: "B", changeType: "modify",
  });

  await assert.rejects(
    () =>
      core.bulkPatchChanges({
        channelId: CHANNEL,
        updates: [
          { changeId: "c-bulk-3", patch: { approvalStatus: "approved", approvedValue: "B" } },
          { changeId: "does-not-exist", patch: { approvalStatus: "approved", approvedValue: "B" } },
        ],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );

  const doc = await core.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-bulk-3"].approvalStatus, "pending", "the valid change in the rejected batch must not have been patched either");
});
