// BL-198 -- docs/roadmap/plans/SEND_TOGETHER_PLAN.md, AC-ST-01..10, 12, 14. Expected values are worked out by hand from the plan's
// definitions (target = video + language + field; a delete collides with every change of its language; 52 units per video).

import assert from "node:assert/strict";
import test from "node:test";
import type { Batch, LedgerRow, LedgerStatus } from "./contracts";
import { DomainError } from "./contracts";
import type { SendableChangeCandidate } from "./adapters/store";
import { createSendApprovedServices } from "./send-approved";

type Field = "title" | "description";

function change(id: string, videoId: string, language: string, field: Field, extra: Partial<SendableChangeCandidate> = {}): SendableChangeCandidate {
  return {
    id,
    videoId,
    language,
    field,
    changeType: "modify",
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
    approvedValue: `${id} text`,
    proposedValue: `${id} text`,
    updatedAt: "2026-10-18T10:00:00.000Z",
    ...extra,
  };
}

function build(sets: Record<string, { channelId: string; changes: SendableChangeCandidate[] }>, options: { liveWrites?: boolean; titles?: Record<string, Record<string, string>> } = {}) {
  const batches: Batch[] = [];
  const rows = new Map<string, LedgerRow[]>();
  const rejected: Array<{ changeSetId: string; changeId: string }> = [];
  const merges: Array<{ batchId: string; rows: Array<{ videoId: string; detail: unknown }> }> = [];
  let counter = 0;
  const service = createSendApprovedServices({
    isLiveWritesEnabled: async () => options.liveWrites ?? true,
    batches: {
      async createBatch(input) {
        const batch: Batch = {
          id: `b${++counter}`,
          channelId: input.channelId,
          status: "PENDING",
          concurrency: 1,
          dryRun: input.dryRun,
          runId: null,
          createdAt: "2026-10-18T11:00:00.000Z",
          startedAt: null,
          completedAt: null,
        };
        batches.push(batch);
        rows.set(
          batch.id,
          input.selections.map((selection, index) => ({
            id: `${batch.id}-r${index}`,
            batchId: batch.id,
            videoId: selection.videoId,
            changeIds: selection.changeIds,
            status: "PENDING" as LedgerStatus,
            error: null,
            verificationResult: null,
            activeAttemptId: null,
            createdAt: batch.createdAt,
            updatedAt: batch.createdAt,
          }))
        );
        return batch;
      },
      async listBatchesByChannel(channelId) {
        return batches.filter((batch) => batch.channelId === channelId);
      },
      async listLedgerRows(batchId) {
        return rows.get(batchId) ?? [];
      },
      async recordMergeAudit(batchId, entries) {
        merges.push({ batchId, rows: entries });
      },
    },
    changeSets: {
      async getChangeSet(id) {
        const entry = sets[id];
        return entry ? { id, channelId: entry.channelId, source: "ai_localization", createdAt: "2026-10-18T09:00:00.000Z" } : null;
      },
      async listChanges(id) {
        return sets[id]?.changes ?? [];
      },
      async rejectChange(input) {
        rejected.push({ changeSetId: input.changeSetId, changeId: input.changeId });
        const target = sets[input.changeSetId]?.changes.find((c) => c.id === input.changeId);
        if (target) {
          target.approvalStatus = "rejected";
          target.approvedValue = null;
        }
      },
      async videoTitles() {
        return new Map([["v1", "Video one"]]);
      },
      // BL-226: the synced copy's titles per video and language; the videos' own language is `en`. Absent: not wired.
      ...(options.titles
        ? {
            async currentTitles() {
              const titles = options.titles ?? {};
              return (videoId: string) =>
                titles[videoId] === undefined
                  ? null
                  : { isOwnLanguage: (language: string) => language === "en", title: (language: string) => titles[videoId][language] ?? "" };
            },
          }
        : {}),
    },
  });
  const rowsOf = (batchId: string) => (rows.get(batchId) ?? []).map((row) => ({ videoId: row.videoId, changeIds: row.changeIds }));
  return { service, batches, rows, rejected, merges, rowsOf };
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to be refused");
}

/** AC-ST-01's sets: A = es title + es description for v1, v2; B = fr title for v1, v2, v3. */
function setsAB() {
  return {
    A: {
      channelId: "UC_A",
      changes: [change("a1", "v1", "es", "title"), change("a2", "v1", "es", "description"), change("a3", "v2", "es", "title"), change("a4", "v2", "es", "description")],
    },
    B: { channelId: "UC_A", changes: [change("b1", "v1", "fr", "title"), change("b2", "v2", "fr", "title"), change("b3", "v3", "fr", "title")] },
  };
}

test("AC-ST-01: two sets without collisions become one batch, one row per video carrying both sets' changes", async () => {
  const h = build(setsAB());
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.deepEqual(
    { videoCount: plan.videoCount, changeCount: plan.changeCount, languageCount: plan.languageCount, estimatedUnits: plan.estimatedUnits, conflicts: plan.conflicts },
    { videoCount: 3, changeCount: 7, languageCount: 2, estimatedUnits: 156, conflicts: [] }
  );
  assert.equal(h.batches.length, 0, "the plan creates nothing");

  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.equal(result.batch.dryRun, false);
  assert.deepEqual(h.rowsOf(result.batch.id), [
    { videoId: "v1", changeIds: ["a1", "a2", "b1"] },
    { videoId: "v2", changeIds: ["a3", "a4", "b2"] },
    { videoId: "v3", changeIds: ["b3"] },
  ]);
  assert.deepEqual(h.rejected, []);
  assert.equal(h.merges.length, 1, "a batch from two sets records its MERGE audit");
});

test("AC-ST-02: the same target in two sets is refused with send_merge_conflicts listing the unit; nothing is created", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "ES", "title")] } });
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].videoId, "v1");
  assert.equal(plan.conflicts[0].videoTitle, "Video one");
  assert.equal(plan.conflicts[0].field, "title");
  assert.deepEqual(plan.conflicts[0].options.map((option) => option.changeSetId), ["A", "B"]);

  const error = await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"] }));
  assert.equal(error.code, "send_merge_conflicts");
  assert.equal((error.details as { conflicts: unknown[] }).conflicts.length, 1);
  assert.equal(h.batches.length, 0);
  assert.deepEqual(h.rejected, []);
});

test("AC-ST-03: resolving with B sends B's change only and rejects A's colliding change", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title")] } });
  const result = await h.service.createBatchForChangeSets({
    channelId: "UC_A",
    changeSetIds: ["A", "B"],
    resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "B" }],
  });
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v1", changeIds: ["b1"] }]);
  assert.deepEqual(h.rejected, [{ changeSetId: "A", changeId: "a1" }]);
  assert.deepEqual(result.rejectedChangeIds, ["a1"]);
  const detail = h.merges[0].rows[0].detail as { kept: Array<{ language: string; field: string | null; changeSetId: string }>; rejectedChangeIds: string[] };
  assert.deepEqual(detail.kept, [{ language: "es", field: "title", changeSetId: "B" }]);
  assert.deepEqual(detail.rejectedChangeIds, ["a1"]);
});

test("AC-ST-04: a delete collides with any change of its language; keeping the delete rejects the title, keeping the title rejects both deletes", async () => {
  const sets = () => ({
    A: { channelId: "UC_A", changes: [change("d1", "v1", "de", "title", { changeType: "delete", proposedValue: "", approvedValue: "" }), change("d2", "v1", "de", "description", { changeType: "delete", proposedValue: "", approvedValue: "" })] },
    B: { channelId: "UC_A", changes: [change("b1", "v1", "de", "title")] },
  });
  const keepDelete = build(sets());
  const r1 = await keepDelete.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "de", field: null, changeSetId: "A" }] });
  assert.deepEqual(keepDelete.rowsOf(r1.batch.id), [{ videoId: "v1", changeIds: ["d1", "d2"] }]);
  assert.deepEqual(keepDelete.rejected, [{ changeSetId: "B", changeId: "b1" }]);

  const keepTitle = build(sets());
  const r2 = await keepTitle.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "de", field: null, changeSetId: "B" }] });
  assert.deepEqual(keepTitle.rowsOf(r2.batch.id), [{ videoId: "v1", changeIds: ["b1"] }]);
  assert.deepEqual(keepTitle.rejected, [
    { changeSetId: "A", changeId: "d1" },
    { changeSetId: "A", changeId: "d2" },
  ]);
});

test("AC-ST-05: different fields of the same language from two sets are not a conflict and share one row", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "description")] } });
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.deepEqual(plan.conflicts, []);
  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v1", changeIds: ["a1", "b1"] }]);
});

test("AC-ST-06: a dry run with a resolution rejects nothing and leaves the losing change out", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title")] } });
  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "A" }], dryRun: true });
  assert.equal(result.batch.dryRun, true);
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v1", changeIds: ["a1"] }]);
  assert.deepEqual(h.rejected, []);
  assert.deepEqual(result.rejectedChangeIds, []);
});

test("AC-ST-07: Live writes off -- a live send creates and rejects nothing; a dry run is still allowed", async () => {
  const sets = () => ({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title")] } });
  const off = build(sets(), { liveWrites: false });
  const error = await rejection(off.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "A" }] }));
  assert.equal(error.code, "live_writes_disabled");
  assert.equal(off.batches.length, 0);
  assert.deepEqual(off.rejected, []);

  const dry = build(sets(), { liveWrites: false });
  const result = await dry.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "A" }], dryRun: true });
  assert.equal(result.batch.dryRun, true);
});

test("AC-ST-08: a set of another channel, or an unknown one, is refused with not_found and nothing changes", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, X: { channelId: "UC_OTHER", changes: [change("x1", "v1", "es", "title")] } });
  assert.equal((await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "X"] }))).code, "not_found");
  assert.equal((await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "NOPE"] }))).code, "not_found");
  assert.equal(h.batches.length, 0);
  assert.deepEqual(h.rejected, []);
});

test("AC-ST-09: written changes are not sent again (a newer live SUCCESS row, or the synced copy already holding the value)", async () => {
  const h = build({
    A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title"), change("a2", "v2", "es", "title", { remoteHolds: true })] },
    B: { channelId: "UC_A", changes: [change("b1", "v3", "fr", "title")] },
  });
  // A real batch wrote a1 after its last update.
  const first = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] });
  h.batches[0] = { ...h.batches[0], status: "COMPLETED" };
  h.rows.set(first.batch.id, h.rows.get(first.batch.id)!.map((row) => ({ ...row, status: "SUCCESS" as LedgerStatus, updatedAt: "2026-10-18T12:00:00.000Z" })));

  const second = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.deepEqual(h.rowsOf(second.batch.id), [{ videoId: "v3", changeIds: ["b1"] }]);

  const error = await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] }));
  assert.equal(error.code, "send_nothing_to_send");
});

test("AC-ST-10: changes held by an unfinished live batch are refused with its id; nothing is rejected", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] }, B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title"), change("b2", "v2", "fr", "title")] } });
  await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] });
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  // a1 and b1 collide (they may still lose), so the plan's in-flight check looks only at b2, which no batch holds.
  assert.equal(plan.inFlightBatchId, null);

  const error = await rejection(
    h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "A" }] })
  );
  assert.equal(error.code, "send_already_in_progress");
  assert.deepEqual(error.details, { batchId: "b1", changeSetIds: ["A", "B"], coversSelection: false });
  assert.deepEqual(h.rejected, []);
});

test("AC-ST-12: written-set counts -- all written, one of two written; a dry-run SUCCESS does not count", async () => {
  const h = build({
    W: { channelId: "UC_A", changes: [change("w1", "v1", "es", "title", { remoteHolds: true }), change("w2", "v1", "es", "description", { remoteHolds: true })] },
    P: { channelId: "UC_A", changes: [change("p1", "v2", "es", "title", { remoteHolds: true }), change("p2", "v2", "es", "description"), change("p3", "v2", "de", "title", { approvalStatus: "rejected", approvedValue: null })] },
    D: { channelId: "UC_A", changes: [change("d1", "v3", "es", "title")] },
  });
  const dry = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["D"], dryRun: true });
  h.rows.set(dry.batch.id, h.rows.get(dry.batch.id)!.map((row) => ({ ...row, status: "SUCCESS" as LedgerStatus, updatedAt: "2026-10-18T12:00:00.000Z" })));

  const counts = await h.service.writtenCountsByChangeSet("UC_A", ["W", "P", "D"]);
  assert.deepEqual(counts.get("W"), { approvedCount: 2, writtenCount: 2 });
  assert.deepEqual(counts.get("P"), { approvedCount: 2, writtenCount: 1 });
  assert.deepEqual(counts.get("D"), { approvedCount: 1, writtenCount: 0 });
});

test("AC-ST-12: a change edited after its write (row older than the change) is not written", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title", { updatedAt: "2026-10-18T13:00:00.000Z" })] } });
  const first = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] });
  h.batches[0] = { ...h.batches[0], status: "COMPLETED" };
  h.rows.set(first.batch.id, h.rows.get(first.batch.id)!.map((row) => ({ ...row, status: "SUCCESS" as LedgerStatus, updatedAt: "2026-10-18T12:00:00.000Z" })));
  assert.deepEqual((await h.service.writtenCountsByChangeSet("UC_A", ["A"])).get("A"), { approvedCount: 1, writtenCount: 0 });
});

test("AC-ST-14: a resolution naming a set outside the unit, or a unit left unresolved, is refused; nothing is rejected or created", async () => {
  const sets = () => ({
    A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title"), change("a2", "v2", "es", "title")] },
    B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title"), change("b2", "v2", "es", "title")] },
    C: { channelId: "UC_A", changes: [change("c1", "v3", "fr", "title")] },
  });
  const wrongSet = build(sets());
  const e1 = await rejection(
    wrongSet.service.createBatchForChangeSets({
      channelId: "UC_A",
      changeSetIds: ["A", "B", "C"],
      resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "C" }, { videoId: "v2", language: "es", field: "title", changeSetId: "A" }],
    })
  );
  assert.equal(e1.code, "validation_failed");
  assert.equal(wrongSet.batches.length, 0);
  assert.deepEqual(wrongSet.rejected, []);

  const partial = build(sets());
  const e2 = await rejection(
    partial.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B", "C"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "A" }] })
  );
  assert.equal(e2.code, "send_merge_conflicts");
  assert.deepEqual((e2.details as { conflicts: Array<{ videoId: string }> }).conflicts.map((c) => c.videoId), ["v2"]);
  assert.equal(partial.batches.length, 0);
  assert.deepEqual(partial.rejected, []);
});

// Review of BL-198: one choice per (video, language) could not keep one set's title and another set's description. Units are per field
// (a delete still makes the whole language one unit), and nothing is rejected before the final rows are known to be valid.
test("review: A (es title + description), B (es title), C (es description) -- one unit per field; any combination makes a valid row", async () => {
  const sets = () => ({
    A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title"), change("a2", "v1", "es", "description")] },
    B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title")] },
    C: { channelId: "UC_A", changes: [change("c1", "v1", "es", "description")] },
  });
  const planned = build(sets());
  const plan = await planned.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B", "C"] });
  assert.deepEqual(
    plan.conflicts.map((c) => ({ field: c.field, options: c.options.map((o) => o.changeSetId) })),
    [
      { field: "title", options: ["A", "B"] },
      { field: "description", options: ["A", "C"] },
    ]
  );

  const mixed = build(sets());
  const r1 = await mixed.service.createBatchForChangeSets({
    channelId: "UC_A",
    changeSetIds: ["A", "B", "C"],
    resolutions: [
      { videoId: "v1", language: "es", field: "title", changeSetId: "B" },
      { videoId: "v1", language: "es", field: "description", changeSetId: "C" },
    ],
  });
  assert.deepEqual(mixed.rowsOf(r1.batch.id), [{ videoId: "v1", changeIds: ["b1", "c1"] }]);
  assert.deepEqual(mixed.rejected.map((r) => r.changeId).sort(), ["a1", "a2"]);

  const keepA = build(sets());
  const r2 = await keepA.service.createBatchForChangeSets({
    channelId: "UC_A",
    changeSetIds: ["A", "B", "C"],
    resolutions: [
      { videoId: "v1", language: "es", field: "title", changeSetId: "A" },
      { videoId: "v1", language: "es", field: "description", changeSetId: "A" },
    ],
  });
  assert.deepEqual(keepA.rowsOf(r2.batch.id), [{ videoId: "v1", changeIds: ["a1", "a2"] }]);
  assert.deepEqual(keepA.rejected.map((r) => r.changeId).sort(), ["b1", "c1"]);
});

test("review: a set with no change in a unit's field is not an option for it, and naming it is refused before anything is rejected", async () => {
  const h = build({
    A: { channelId: "UC_A", changes: [change("a1", "v1", "es", "title")] },
    B: { channelId: "UC_A", changes: [change("b1", "v1", "es", "title")] },
    C: { channelId: "UC_A", changes: [change("c1", "v1", "es", "description")] },
  });
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B", "C"] });
  assert.deepEqual(plan.conflicts.map((c) => c.options.map((o) => o.changeSetId)), [["A", "B"]]);
  const error = await rejection(
    h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B", "C"], resolutions: [{ videoId: "v1", language: "es", field: "title", changeSetId: "C" }] })
  );
  assert.equal(error.code, "validation_failed");
  assert.deepEqual(h.rejected, []);
  assert.equal(h.batches.length, 0);
});

// BL-226: YouTube refuses a whole video whose translation would have no title (live 2026-10-26, "The request metadata is invalid.").
// Expected by hand: the plan names each such (video, language) before sending, the send refuses them before creating or rejecting
// anything, and a title on YouTube already or a title from another set sent together is enough.

test("BL-226: a description whose title was rejected, for a language the video has no title in, is named in the plan and refuses the send", async () => {
  const h = build(
    { A: { channelId: "UC_A", changes: [change("a1", "v1", "it", "description"), change("a2", "v1", "it", "title", { approvalStatus: "rejected", approvedValue: null }), change("a3", "v1", "de", "title"), change("a4", "v1", "de", "description")] } },
    { titles: { v1: {} } }
  );
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A"] });
  assert.deepEqual(plan.untitled, [{ videoId: "v1", videoTitle: "Video one", language: "it" }]);
  const error = await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] }));
  assert.equal(error.code, "send_untitled_translations");
  assert.deepEqual((error.details as { untitled: unknown }).untitled, [{ videoId: "v1", videoTitle: "Video one", language: "it" }]);
  assert.equal(h.batches.length, 0);
  assert.deepEqual(h.rejected, []);
});

test("BL-226: the same description goes when the video already has a title in that language on YouTube", async () => {
  const h = build({ A: { channelId: "UC_A", changes: [change("a1", "v1", "it", "description")] } }, { titles: { v1: { it: "Titolo" } } });
  assert.deepEqual((await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A"] })).untitled, []);
  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] });
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v1", changeIds: ["a1"] }]);
});

test("BL-226: a title from another set sent together completes the translation (the owner's two sets of 2026-10-26)", async () => {
  const h = build(
    {
      A: { channelId: "UC_A", changes: [change("a1", "v1", "it", "description"), change("a2", "v1", "it", "title", { approvalStatus: "rejected", approvedValue: null })] },
      B: { channelId: "UC_A", changes: [change("b1", "v1", "it", "title")] },
    },
    { titles: { v1: {} } }
  );
  assert.deepEqual((await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"] })).untitled, []);
  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"] });
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v1", changeIds: ["a1", "b1"] }]);
  // Alone, set A still cannot go.
  assert.equal((await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"] }))).code, "send_untitled_translations");
});

// BL-227 (LANGUAGES_REVIEW_PLAN.md AC-LR-11): «Отправить одобренное этого видео» -- the same send, only the named videos' changes.
test("BL-227 AC-LR-11: videoIds sends only those videos' changes; an empty list is refused", async () => {
  const h = build(setsAB());
  const plan = await h.service.planSendTogether({ channelId: "UC_A", changeSetIds: ["A", "B"], videoIds: ["v2"] });
  assert.deepEqual([plan.videoCount, plan.changeCount], [1, 3]);
  const result = await h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A", "B"], videoIds: ["v2"] });
  assert.deepEqual(h.rowsOf(result.batch.id), [{ videoId: "v2", changeIds: ["a3", "a4", "b2"] }]);
  assert.equal((await rejection(h.service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["A"], videoIds: [] }))).code, "validation_failed");
});
