import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { reportChecks } from "./report";

// BL-227 (LANGUAGES_REVIEW_PLAN.md §5, AC-LR-06): the report's input bounds are checked before anything is stored.

function fake() {
  const stored: unknown[] = [];
  return {
    stored,
    deps: {
      newId: () => "r-1",
      async addCheckReport(input: unknown) {
        stored.push(input);
        return { report: { id: "r-1", reportedAt: "2026-10-26T17:00:00.000Z" }, replacedId: null };
      },
    },
  };
}
const entry = { language: "it", field: "title", verdict: "fail", checks: [{ id: "length", result: "fail", detail: "112 of 100" }] };

test("a valid report is stored with the caller as the reporter and answered with its id", async () => {
  const { deps, stored } = fake();
  const result = await reportChecks(deps, { channelId: "UC_A", changeSetId: "cs-1", entries: [entry] }, "worker");
  assert.deepEqual(result, { reportId: "r-1", reportedAt: "2026-10-26T17:00:00.000Z", replaced: null });
  assert.deepEqual(stored, [{ channelId: "UC_A", id: "r-1", changeSetId: "cs-1", reportedBy: "worker", entries: [entry] }]);
});

test("bounds: no entries, a bad verdict, an over-long detail or note, or an unknown key refuse with validation_failed and store nothing", async () => {
  const { deps, stored } = fake();
  for (const bad of [
    { channelId: "UC_A", changeSetId: "cs-1", entries: [] },
    { channelId: "UC_A", changeSetId: "cs-1", entries: [{ ...entry, verdict: "ok" }] },
    { channelId: "UC_A", changeSetId: "cs-1", entries: [{ ...entry, checks: [{ id: "x", result: "pass", detail: "d".repeat(501) }] }] },
    { channelId: "UC_A", changeSetId: "cs-1", entries: [{ ...entry, note: "n".repeat(1001) }] },
    { channelId: "UC_A", changeSetId: "cs-1", entries: [{ ...entry, approved: true }] },
    { channelId: "UC_A", changeSetId: "cs-1", entries: [entry], approve: true },
  ]) {
    await assert.rejects(reportChecks(deps, bad, "factory"), (error: unknown) => error instanceof DomainError && error.code === "validation_failed");
  }
  assert.deepEqual(stored, []);
});
