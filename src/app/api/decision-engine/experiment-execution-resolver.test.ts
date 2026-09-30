// ---------------------------------------------------------------------------
// Acceptance criteria derived from docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §7 (AGENTS.md §L
// -- written from the requirement, not copied from a draft implementation's own output). Mirrors
// evidence-reference-resolver.test.ts's own precedent: services.test.ts only proves the service
// layer does whatever a FAKE resolver says -- this file is what actually proves the REAL
// resolver's own grouping/eligibility/pagination logic.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createRealExperimentExecutionResolver } from "./experiment-execution-resolver";

type FakeChange = {
  id: string;
  videoId: string;
  approvalStatus: "approved" | "pending" | "rejected";
  validationStatus: "valid" | "invalid";
  conflictStatus: "none" | "conflict";
  approvedValue: string | null;
  proposedValue: string;
};

function createFakeChangeSetCore(args: {
  channelId: string;
  changeSetId: string;
  changes: FakeChange[];
  totalOverride?: number;
  throwNotFound?: boolean;
}) {
  return {
    async getChangeSet(input: { channelId: string; changeSetId: string; status?: string; pageSize?: number }) {
      if (args.throwNotFound || input.channelId !== args.channelId || input.changeSetId !== args.changeSetId) {
        throw new DomainError({ code: "not_found", message: "Change set not found for this channel" });
      }
      return {
        changeSet: { channelId: args.channelId },
        changes: args.changes,
        pagination: { page: 1, pageSize: input.pageSize ?? 500, total: args.totalOverride ?? args.changes.length },
      } as never;
    },
  };
}

function createFakeBatchCore(capturedCalls: unknown[]) {
  return {
    async createBatch(input: unknown) {
      capturedCalls.push(input);
      return { id: "batch-real-1" } as never;
    },
  };
}

test("verifyChangeSetBelongsToChannel: true when the real getChangeSet call succeeds", async () => {
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({ channelId: "UC1", changeSetId: "cs-1", changes: [] }),
    batchCore: createFakeBatchCore([]),
  });
  assert.equal(await resolver.verifyChangeSetBelongsToChannel("cs-1", "UC1"), true);
});

test("verifyChangeSetBelongsToChannel: false when getChangeSet throws not_found (wrong channel or nonexistent id)", async () => {
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({ channelId: "UC1", changeSetId: "cs-1", changes: [] }),
    batchCore: createFakeBatchCore([]),
  });
  assert.equal(await resolver.verifyChangeSetBelongsToChannel("cs-1", "UC-WRONG"), false);
  assert.equal(await resolver.verifyChangeSetBelongsToChannel("cs-DOES-NOT-EXIST", "UC1"), false);
});

test("verifyChangeSetBelongsToChannel: a non-not_found error still propagates, never silently folded to false", async () => {
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: {
      async getChangeSet(): Promise<never> {
        throw new DomainError({ code: "validation_failed", message: "boom" });
      },
    },
    batchCore: createFakeBatchCore([]),
  });
  await assert.rejects(
    () => resolver.verifyChangeSetBelongsToChannel("cs-1", "UC1"),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("createDryRunBatch: groups eligible changes by videoId into selections, forwards dryRun exactly as given", async () => {
  const calls: unknown[] = [];
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({
      channelId: "UC1",
      changeSetId: "cs-1",
      changes: [
        { id: "c1", videoId: "v1", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "x" },
        { id: "c2", videoId: "v1", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "y" },
        { id: "c3", videoId: "v2", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "z" },
      ],
    }),
    batchCore: createFakeBatchCore(calls),
  });

  const result = await resolver.createDryRunBatch({ channelId: "UC1", changeSetId: "cs-1", dryRun: false });
  assert.equal(result.batchId, "batch-real-1");
  assert.equal(result.videoCount, 2, "two distinct videoIds -> 2 ledger-row selections");
  assert.deepEqual(calls, [
    {
      channelId: "UC1",
      selections: [
        { videoId: "v1", changeIds: ["c1", "c2"] },
        { videoId: "v2", changeIds: ["c3"] },
      ],
      dryRun: false,
    },
  ]);
});

test("createDryRunBatch: excludes invalid/conflicting/edited-after-approval changes, never aborts the whole call for them", async () => {
  const calls: unknown[] = [];
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({
      channelId: "UC1",
      changeSetId: "cs-1",
      changes: [
        { id: "c1", videoId: "v1", approvalStatus: "approved", validationStatus: "invalid", conflictStatus: "none", approvedValue: null, proposedValue: "x" },
        { id: "c2", videoId: "v2", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "conflict", approvedValue: null, proposedValue: "y" },
        { id: "c3", videoId: "v3", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: "old", proposedValue: "new" },
        { id: "c4", videoId: "v4", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "ok" },
      ],
    }),
    batchCore: createFakeBatchCore(calls),
  });

  const result = await resolver.createDryRunBatch({ channelId: "UC1", changeSetId: "cs-1", dryRun: true });
  assert.equal(result.videoCount, 1, "only c4/v4 is actually eligible");
  assert.deepEqual((calls[0] as { selections: unknown[] }).selections, [{ videoId: "v4", changeIds: ["c4"] }]);
});

test("createDryRunBatch: excludes a change whose approvalStatus is not \"approved\", reusing the real isApprovalStillValid rule (independent review finding)", async () => {
  // The resolver's own eligibility check used to be a hand-copied predicate that never checked
  // approvalStatus at all -- this proves the real, shared rule (batches/services.ts's
  // isApprovalStillValid) is what actually runs now, not just that the other three fields work.
  const calls: unknown[] = [];
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({
      channelId: "UC1",
      changeSetId: "cs-1",
      changes: [
        { id: "c1", videoId: "v1", approvalStatus: "pending", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "x" },
        { id: "c2", videoId: "v2", approvalStatus: "rejected", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "y" },
        { id: "c3", videoId: "v3", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "z" },
      ],
    }),
    batchCore: createFakeBatchCore(calls),
  });

  const result = await resolver.createDryRunBatch({ channelId: "UC1", changeSetId: "cs-1", dryRun: true });
  assert.equal(result.videoCount, 1, "only the genuinely approved c3/v3 is eligible");
  assert.deepEqual((calls[0] as { selections: unknown[] }).selections, [{ videoId: "v3", changeIds: ["c3"] }]);
});

test("createDryRunBatch: throws EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES when zero changes are eligible, never calls createBatch", async () => {
  const calls: unknown[] = [];
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({
      channelId: "UC1",
      changeSetId: "cs-1",
      changes: [{ id: "c1", videoId: "v1", approvalStatus: "approved", validationStatus: "invalid", conflictStatus: "none", approvedValue: null, proposedValue: "x" }],
    }),
    batchCore: createFakeBatchCore(calls),
  });

  await assert.rejects(
    () => resolver.createDryRunBatch({ channelId: "UC1", changeSetId: "cs-1", dryRun: true }),
    (error: unknown) => error instanceof DomainError && error.code === "EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES"
  );
  assert.equal(calls.length, 0);
});

test("createDryRunBatch: throws EXPERIMENT_CHANGE_SET_TOO_LARGE when the real total exceeds the 500-row page size, never calls createBatch", async () => {
  const calls: unknown[] = [];
  const resolver = createRealExperimentExecutionResolver({
    changeSetCore: createFakeChangeSetCore({
      channelId: "UC1",
      changeSetId: "cs-1",
      changes: [{ id: "c1", videoId: "v1", approvalStatus: "approved", validationStatus: "valid", conflictStatus: "none", approvedValue: null, proposedValue: "x" }],
      totalOverride: 501,
    }),
    batchCore: createFakeBatchCore(calls),
  });

  await assert.rejects(
    () => resolver.createDryRunBatch({ channelId: "UC1", changeSetId: "cs-1", dryRun: true }),
    (error: unknown) => error instanceof DomainError && error.code === "EXPERIMENT_CHANGE_SET_TOO_LARGE"
  );
  assert.equal(calls.length, 0);
});
