// BL-232 (PRD-REQ-0043, owner msgs 3782/3784): moving a localization zh-Hans -> zh-CN through the ordinary Change Set + Batch path.
// Acceptance from the request, fixed before implementation:
//  - after the write a video has zh-CN with exactly the previous zh-Hans title/description and no zh-Hans;
//  - no other language gets new or changed text; defaultLanguage and every other snippet field are untouched;
//  - the read-back counts the write as done only when zh-CN holds the text AND zh-Hans is gone;
//  - a delete is never sent without its add (a partial approval would lose the Chinese text), on the send path and the manual one;
//  - an ordinary language removal (deletes only) keeps working.

import assert from "node:assert/strict";
import test from "node:test";
import type { Batch, LedgerRow, LedgerStatus } from "./contracts";
import { DomainError } from "./contracts";
import type { SendableChangeCandidate } from "./adapters/store";
import { createSendApprovedServices } from "./send-approved";
import { buildSafeLocalizationsPayload, classifyFreshStateAgainstAttempt, detectPreWriteConflict, type PendingChange } from "./merge";
import { unpairedDeletes } from "./targets";
import type { FreshVideoContext } from "@/lib/shared-localization-merge";

const ZH_TITLE = "爵士咖啡馆 · 放松音乐  ";
const ZH_DESC = "第一行\n第二行 — 带有空格和表情 ☕\n";

function fresh(localizations: FreshVideoContext["localizations"]): FreshVideoContext {
  return {
    snippet: {
      title: "Jazz Cafe",
      description: "Original description",
      defaultLanguage: "en",
      categoryId: "10",
      tags: ["jazz", "cafe"],
    },
    localizations,
  };
}

function moveChanges(): PendingChange[] {
  return [
    { id: "d-t", language: "zh-Hans", field: "title", baselineValue: ZH_TITLE, proposedValue: "", changeType: "delete" },
    { id: "d-d", language: "zh-Hans", field: "description", baselineValue: ZH_DESC, proposedValue: "", changeType: "delete" },
    { id: "a-t", language: "zh-CN", field: "title", baselineValue: "", proposedValue: ZH_TITLE, changeType: "add" },
    { id: "a-d", language: "zh-CN", field: "description", baselineValue: "", proposedValue: ZH_DESC, changeType: "add" },
  ];
}

test("merge: zh-CN gets the zh-Hans text byte-for-byte, zh-Hans is gone, other languages and the snippet are untouched", () => {
  const before = fresh({
    "zh-Hans": { title: ZH_TITLE, description: ZH_DESC },
    es: { title: "Café de jazz", description: "Descripción" },
    ja: { title: "ジャズカフェ", description: "説明" },
  });

  const payload = buildSafeLocalizationsPayload(before, moveChanges());

  assert.deepEqual(payload.localizations, {
    "zh-CN": { title: ZH_TITLE, description: ZH_DESC },
    es: { title: "Café de jazz", description: "Descripción" },
    ja: { title: "ジャズカフェ", description: "説明" },
  });
  assert.equal(payload.snippet.title, "Jazz Cafe");
  assert.equal(payload.snippet.description, "Original description");
  assert.equal(payload.snippet.defaultLanguage, "en");
  assert.equal(payload.snippet.categoryId, "10");
  assert.deepEqual(payload.snippet.tags, ["jazz", "cafe"]);
  assert.equal(detectPreWriteConflict(moveChanges(), before).status, "none");
});

test("pre-write: a zh-CN added on YouTube meanwhile, or a zh-Hans edited meanwhile, is a conflict (nothing is overwritten)", () => {
  const zhCnAppeared = fresh({ "zh-Hans": { title: ZH_TITLE, description: ZH_DESC }, "zh-CN": { title: "其他", description: "其他" } });
  assert.equal(detectPreWriteConflict(moveChanges(), zhCnAppeared).status, "conflict");
  const zhHansEdited = fresh({ "zh-Hans": { title: "edited", description: ZH_DESC } });
  assert.equal(detectPreWriteConflict(moveChanges(), zhHansEdited).status, "conflict");
});

test("read-back: done only when zh-CN holds the text and zh-Hans is gone", () => {
  const written = fresh({ "zh-CN": { title: ZH_TITLE, description: ZH_DESC }, es: { title: "Café de jazz", description: "Descripción" } });
  assert.equal(classifyFreshStateAgainstAttempt(moveChanges(), written), "matches_requested");

  const bothStill = fresh({ "zh-Hans": { title: ZH_TITLE, description: ZH_DESC }, "zh-CN": { title: ZH_TITLE, description: ZH_DESC } });
  assert.notEqual(classifyFreshStateAgainstAttempt(moveChanges(), bothStill), "matches_requested");

  const textChanged = fresh({ "zh-CN": { title: ZH_TITLE.trim(), description: ZH_DESC } });
  assert.notEqual(classifyFreshStateAgainstAttempt(moveChanges(), textChanged), "matches_requested");

  const nothingHappened = fresh({ "zh-Hans": { title: ZH_TITLE, description: ZH_DESC } });
  assert.equal(classifyFreshStateAgainstAttempt(moveChanges(), nothingHappened), "matches_baseline");
});

test("unpairedDeletes: a delete is unpaired when its set's other change on the same video is neither selected nor on YouTube", () => {
  const set = [
    { id: "d", videoId: "v1", changeType: "delete" },
    { id: "a", videoId: "v1", changeType: "add" },
    { id: "d2", videoId: "v2", changeType: "delete" },
  ];
  const of = () => set;
  assert.deepEqual(unpairedDeletes([set[0]!], of, () => false).map((c) => c.id), ["d"]);
  assert.deepEqual(unpairedDeletes([set[0]!, set[1]!], of, () => false), []);
  assert.deepEqual(unpairedDeletes([set[0]!], of, (p) => p.id === "a"), [], "the add already on YouTube");
  assert.deepEqual(unpairedDeletes([set[2]!], of, () => false), [], "a delete-only video has no partner");
});

// --- the send service ------------------------------------------------------------------------------------------------------------

function candidate(partial: Partial<SendableChangeCandidate> & { id: string; videoId: string }): SendableChangeCandidate {
  return {
    approvalStatus: "approved",
    validationStatus: "valid",
    conflictStatus: "none",
    approvedValue: "value",
    proposedValue: "value",
    updatedAt: "2026-10-29T00:00:00.000Z",
    ...partial,
  };
}

function moveSet(overrides: Partial<Record<"dt" | "dd" | "at" | "ad", Partial<SendableChangeCandidate>>> = {}): SendableChangeCandidate[] {
  return [
    candidate({ id: "dt", videoId: "v1", language: "zh-Hans", field: "title", changeType: "delete", approvedValue: "", proposedValue: "", ...overrides.dt }),
    candidate({ id: "dd", videoId: "v1", language: "zh-Hans", field: "description", changeType: "delete", approvedValue: "", proposedValue: "", ...overrides.dd }),
    candidate({ id: "at", videoId: "v1", language: "zh-CN", field: "title", changeType: "add", approvedValue: ZH_TITLE, proposedValue: ZH_TITLE, ...overrides.at }),
    candidate({ id: "ad", videoId: "v1", language: "zh-CN", field: "description", changeType: "add", approvedValue: ZH_DESC, proposedValue: ZH_DESC, ...overrides.ad }),
  ];
}

function build(changes: SendableChangeCandidate[], options: { holds?: (change: SendableChangeCandidate) => boolean } = {}) {
  const batches: Batch[] = [];
  const rows = new Map<string, LedgerRow[]>();
  const rejected: string[] = [];
  const service = createSendApprovedServices({
    isLiveWritesEnabled: async () => true,
    batches: {
      async createBatch(input) {
        const batch: Batch = { id: `b${batches.length + 1}`, channelId: input.channelId, status: "PENDING", concurrency: 1, dryRun: input.dryRun, runId: null, createdAt: new Date().toISOString(), startedAt: null, completedAt: null };
        batches.push(batch);
        rows.set(batch.id, input.selections.map((s, i) => ({ id: `r${i}`, batchId: batch.id, videoId: s.videoId, changeIds: s.changeIds, status: "PENDING" as LedgerStatus, error: null, verificationResult: null, activeAttemptId: null, createdAt: batch.createdAt, updatedAt: batch.createdAt })));
        return batch;
      },
      async listBatchesByChannel(channelId) {
        return batches.filter((b) => b.channelId === channelId);
      },
      async listLedgerRows(batchId) {
        return rows.get(batchId) ?? [];
      },
    },
    changeSets: {
      async getChangeSet(id) {
        return id === "MOVE" ? { id, channelId: "UC_A" } : null;
      },
      async listChanges(id) {
        return id === "MOVE" ? changes : [];
      },
      ...(options.holds ? { remoteHolds: async () => options.holds! } : {}),
      async rejectChange(input) {
        rejected.push(input.changeId);
      },
    },
  });
  return { service, batches, rows, rejected };
}

test("send: an approved move goes as ONE row (one videos.update) with the delete and the add together", async () => {
  const { service, rows } = build(moveSet());
  const result = await service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"] });
  const created = rows.get(result.batch.id)!;
  assert.equal(created.length, 1);
  assert.deepEqual([...created[0]!.changeIds].sort(), ["ad", "at", "dd", "dt"]);
});

test("send: the delete approved but the add pending (or rejected) is refused, nothing created or rejected", async () => {
  for (const at of [{ approvalStatus: "pending", approvedValue: null }, { approvalStatus: "rejected", approvedValue: null }, { conflictStatus: "conflict" }]) {
    const { service, batches, rejected } = build(moveSet({ at }));
    await assert.rejects(
      service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"] }),
      (error: unknown) => error instanceof DomainError && error.code === "send_unpaired_language_move"
    );
    assert.equal(batches.length, 0);
    assert.deepEqual(rejected, []);
  }
});

test("send: a selection of only the delete's ids (review screen changeIds) is refused too", async () => {
  const { service, batches } = build(moveSet());
  await assert.rejects(
    service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"], changeIds: ["dt", "dd"] }),
    (error: unknown) => error instanceof DomainError && error.code === "send_unpaired_language_move"
  );
  assert.equal(batches.length, 0);
});

test("send: the add approved but the delete not yet is allowed (nothing lost: both languages stay until the delete is sent)", async () => {
  const { service, rows } = build(moveSet({ dt: { approvalStatus: "pending", approvedValue: null }, dd: { approvalStatus: "pending", approvedValue: null } }));
  const result = await service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"] });
  assert.deepEqual([...rows.get(result.batch.id)![0]!.changeIds].sort(), ["ad", "at"]);
});

test("send: the delete alone is allowed once its add is already on YouTube (the synced copy holds it)", async () => {
  const { service, rows } = build(moveSet(), { holds: (change) => change.changeType === "add" });
  const result = await service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"] });
  assert.deepEqual([...rows.get(result.batch.id)![0]!.changeIds].sort(), ["dd", "dt"]);
});

test("send: an ordinary removal set (deletes only) is unaffected", async () => {
  const { service, rows } = build(moveSet().filter((change) => change.changeType === "delete"));
  const result = await service.createBatchForChangeSets({ channelId: "UC_A", changeSetIds: ["MOVE"] });
  assert.deepEqual([...rows.get(result.batch.id)![0]!.changeIds].sort(), ["dd", "dt"]);
});
