import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createChangeDraftsCore } from "./services";
import type { ChangeDraftsStoreAdapter } from "./adapters/automerge-store";

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

const CHANNEL = "UC_test";

test("createChangeSet then addChange persists and is readable back via getDocument", async () => {
  const core = createChangeDraftsCore({ store: fakeStore() });

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

test("addChange rejects a change referencing a nonexistent change set", async () => {
  const core = createChangeDraftsCore({ store: fakeStore() });

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
  const core = createChangeDraftsCore({ store: fakeStore() });
  await assert.rejects(
    () => core.updateProposedValue({ channelId: CHANNEL, changeId: "does-not-exist", proposedValue: "x" }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

async function seedTwoDeviceDrafts() {
  // Two independent "devices" each holding their own store, both starting from the exact same
  // synced state -- mirrors CD1's spike (AUTOMERGE_MIGRATION_PLAN.md §3), now as a permanent
  // regression test against the real service layer rather than a throwaway script.
  const deviceA = createChangeDraftsCore({ store: fakeStore() });
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
  const deviceB = createChangeDraftsCore({ store: deviceBStore });

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

test("getDocument/exportBytes/listConflicts reject a channel that was never saved, rather than silently returning an empty document", async () => {
  const core = createChangeDraftsCore({ store: fakeStore() });

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
  const deviceC = createChangeDraftsCore({ store: deviceCStore });

  const deviceDStore = fakeStore();
  await deviceDStore.saveDocumentBytes(CHANNEL, pristineBytes);
  const deviceD = createChangeDraftsCore({ store: deviceDStore });

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

// AC-CRDT-03 (lossless migration from existing SQL rows) is deliberately not tested here -- this
// module's own tests only cover the Automerge document layer in isolation (CD1/CD2). The
// migration itself is CD4's job and gets its own acceptance test when that slice is built.

test("mergeIncoming rejects malformed input before touching the store", async () => {
  const core = createChangeDraftsCore({ store: fakeStore() });
  await assert.rejects(
    () => core.mergeIncoming({ channelId: CHANNEL, incomingBytes: "not-bytes" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});
