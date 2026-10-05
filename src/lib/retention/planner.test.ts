import assert from "node:assert/strict";
import test from "node:test";
import { planDraftPurge, planWriteLogPurge } from "./planner";
import type { RetentionBatchFacts, RetentionChangeSetFacts, RetentionLedgerRowFacts } from "./contracts";

// Expected values come from the owner's rules (2026-10-04), not from the implementation:
// in_review is never deleted; rejected is deleted after the draft period; approved only once every approved change is SUCCESS in a real batch.

const NOW = new Date("2026-10-20T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function set(id: string, status: RetentionChangeSetFacts["status"], ageDays: number, approvals: Array<"approved" | "rejected" | "pending"> = []): RetentionChangeSetFacts {
  return {
    id,
    status,
    updatedAt: days(ageDays),
    changes: approvals.map((approvalStatus, i) => ({ id: `${id}-c${i}`, approvalStatus, updatedAt: days(ageDays) })),
  };
}

function row(batchId: string, status: string, changeIds: string[], ageDays: number, batchDryRun = false): RetentionLedgerRowFacts {
  return { id: `${batchId}-${changeIds.join("+")}`, batchId, status, changeIds, updatedAt: days(ageDays), batchDryRun };
}

test("rejected: purged at 7 days old, kept at 6", () => {
  const plan = planDraftPurge([set("old", "rejected", 7, ["rejected"]), set("young", "rejected", 6, ["rejected"])], [], NOW, 7);
  assert.deepEqual(plan.changeSetIds, ["old"]);
});

test("in_review is never purged, however old", () => {
  assert.deepEqual(planDraftPurge([set("a", "in_review", 400, ["pending"])], [], NOW, 7).changeSetIds, []);
});

test("approved with every approved change SUCCESS in a real batch: purged", () => {
  const plan = planDraftPurge([set("a", "approved", 10, ["approved", "approved"])], [row("b1", "SUCCESS", ["a-c0", "a-c1"], 9)], NOW, 7);
  assert.deepEqual(plan.changeSetIds, ["a"]);
});

test("approved but one approved change only has a FAILED row: kept", () => {
  const plan = planDraftPurge(
    [set("a", "approved", 10, ["approved", "approved"])],
    [row("b1", "SUCCESS", ["a-c0"], 9), row("b1", "FAILED", ["a-c1"], 9)],
    NOW,
    7
  );
  assert.deepEqual(plan.changeSetIds, []);
});

test("approved: a later SUCCESS supersedes an earlier FAILED row for the same change", () => {
  const plan = planDraftPurge(
    [set("a", "approved", 10, ["approved"])],
    [row("b1", "FAILED", ["a-c0"], 9), row("b2", "SUCCESS", ["a-c0"], 8)],
    NOW,
    7
  );
  assert.deepEqual(plan.changeSetIds, ["a"]);
});

test("approved whose only SUCCESS is in a dry-run batch: kept (a dry run wrote nothing)", () => {
  const plan = planDraftPurge([set("a", "approved", 10, ["approved"])], [row("b1", "SUCCESS", ["a-c0"], 9, true), row("b1", "DRY_RUN_COMPLETE", ["a-c0"], 9, true)], NOW, 7);
  assert.deepEqual(plan.changeSetIds, []);
});

test("approved with no ledger row at all, or only in-flight rows: kept", () => {
  for (const status of ["PENDING", "AWAITING_EXECUTION", "APPLYING", "UNKNOWN", "CONFLICT", "CANCELLED", "ABORTED_SYSTEMIC"]) {
    const plan = planDraftPurge([set("a", "approved", 10, ["approved"])], [row("b1", status, ["a-c0"], 9)], NOW, 7);
    assert.deepEqual(plan.changeSetIds, [], status);
  }
  assert.deepEqual(planDraftPurge([set("a", "approved", 10, ["approved"])], [], NOW, 7).changeSetIds, []);
});

test("partially_approved: only the approved changes need a SUCCESS; the rejected one needs nothing", () => {
  const plan = planDraftPurge([set("a", "partially_approved", 10, ["approved", "rejected"])], [row("b1", "SUCCESS", ["a-c0"], 9)], NOW, 7);
  assert.deepEqual(plan.changeSetIds, ["a"]);
});

test("age is the latest activity: a recent SUCCESS row keeps an old approved set until the period passes", () => {
  const plan = planDraftPurge([set("a", "approved", 30, ["approved"])], [row("b1", "SUCCESS", ["a-c0"], 3)], NOW, 7);
  assert.deepEqual(plan.changeSetIds, []);
});

test("the draft period setting is honoured (1 day vs 30 days)", () => {
  const facts = [set("a", "rejected", 5, ["rejected"])];
  assert.deepEqual(planDraftPurge(facts, [], NOW, 1).changeSetIds, ["a"]);
  assert.deepEqual(planDraftPurge(facts, [], NOW, 30).changeSetIds, []);
});

function batch(id: string, status: string, ageDays: number | null, rowStatuses: string[], changeIds: string[][] = []): RetentionBatchFacts {
  return {
    id,
    status,
    completedAt: ageDays === null ? null : days(ageDays),
    rows: rowStatuses.map((s, i) => ({ status: s, changeIds: changeIds[i] ?? [] })),
  };
}

test("write log: a completed all-SUCCESS batch is purged at 30 days, kept at 29", () => {
  const plan = planWriteLogPurge([batch("old", "COMPLETED", 30, ["SUCCESS"]), batch("young", "COMPLETED", 29, ["SUCCESS"])], new Set(), NOW, 30);
  assert.deepEqual(plan.batchIds, ["old"]);
});

test("write log: dry-run-only rows count as settled", () => {
  assert.deepEqual(planWriteLogPurge([batch("d", "COMPLETED", 40, ["DRY_RUN_COMPLETE"])], new Set(), NOW, 30).batchIds, ["d"]);
});

test("write log: any FAILED / CONFLICT / CANCELLED / ABORTED_SYSTEMIC / UNKNOWN row keeps the batch forever", () => {
  for (const bad of ["FAILED", "CONFLICT", "CANCELLED", "ABORTED_SYSTEMIC", "UNKNOWN", "PENDING", "APPLYING"]) {
    assert.deepEqual(planWriteLogPurge([batch("b", "COMPLETED", 400, ["SUCCESS", bad])], new Set(), NOW, 30).batchIds, [], bad);
  }
});

test("write log: RUNNING, PENDING and ABORTED batches are never purged", () => {
  for (const status of ["RUNNING", "PENDING", "ABORTED"]) {
    assert.deepEqual(planWriteLogPurge([batch("b", status, status === "RUNNING" || status === "PENDING" ? null : 400, ["SUCCESS"])], new Set(), NOW, 30).batchIds, [], status);
  }
});

test("write log: kept while one of its changes still sits in a surviving change set", () => {
  const plan = planWriteLogPurge([batch("b", "COMPLETED", 60, ["SUCCESS"], [["c1"]])], new Set(["c1"]), NOW, 30);
  assert.deepEqual(plan.batchIds, []);
});

test("approved: written, then edited and re-approved afterwards -> kept (the new value was never sent)", () => {
  const edited: RetentionChangeSetFacts = {
    id: "a",
    status: "approved",
    updatedAt: days(10),
    // change last updated 9 days ago; the SUCCESS row is 10 days old, so the write predates the edit
    changes: [{ id: "a-c0", approvalStatus: "approved", updatedAt: days(9) }],
  };
  assert.deepEqual(planDraftPurge([edited], [row("b1", "SUCCESS", ["a-c0"], 10)], NOW, 7).changeSetIds, []);
});

test("a set with a pending change is kept even if its stored status says rejected or approved", () => {
  for (const status of ["rejected", "approved", "partially_approved"] as const) {
    const s = set("a", status, 30, ["approved", "pending"]);
    assert.deepEqual(planDraftPurge([s], [row("b1", "SUCCESS", ["a-c0"], 29)], NOW, 7).changeSetIds, [], status);
  }
});
