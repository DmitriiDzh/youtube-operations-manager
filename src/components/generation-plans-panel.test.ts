import assert from "node:assert/strict";
import test from "node:test";
import { describeEvent, describeStage, formatEta } from "./generation-plans-panel";

// BL-143 (GENERATION_PLANS_PLAN.md §3): how the Plans tab words the derived numbers.

const counts = (over: Partial<Record<string, number>>) => ({ planned: 10, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, cancelled: 0, accepted: 0, rejected: 0, ...over });

test("a generate stage's bar counts done jobs of the plan's target; a review stage's bar counts accepted (and done)", () => {
  assert.deepEqual(describeStage("in_app", counts({ done: 4, running: 1, failed: 2 })), { value: 4, total: 10, percent: 40, words: "done 4 · running 1 · failed 2" });
  assert.deepEqual(describeStage("owner_review", counts({ accepted: 3, rejected: 5 })), { value: 3, total: 10, percent: 30, words: "accepted 3 · rejected 5" });
  assert.equal(describeStage("external", counts({})).words, "nothing yet");
  assert.equal(describeStage("in_app", counts({ planned: 2, done: 5 })).percent, 100, "never over 100 %");
  assert.equal(describeStage("in_app", counts({ planned: 0 })).percent, 0);
});

test("the time left is in minutes, then hours and minutes; unknown is a dash", () => {
  assert.equal(formatEta(null), "—");
  assert.equal(formatEta(30), "under a minute");
  assert.equal(formatEta(380), "about 6 min");
  assert.equal(formatEta(4800), "about 1 h 20 min");
});

test("events read as one line: a stopped session says why, a verdict says the rating", () => {
  assert.equal(describeEvent({ at: "", kind: "session_stopped", actor: "app", details: { stopReason: "released after last job (1 min after the last job finished)" } }), "session stopped -- released after last job (1 min after the last job finished)");
  assert.equal(describeEvent({ at: "", kind: "owner_verdict", actor: "owner", details: { itemKey: "C8/U04", result: "rejected", rating: 6 } }), "your verdict C8/U04: rejected 6/10");
  assert.equal(describeEvent({ at: "", kind: "job_interrupted", actor: "app", details: { itemKey: "C6/F1", error: "interrupted by a server restart" } }), "job interrupted C6/F1: interrupted by a server restart");
});

test("a report's age reads in minutes, then hours", async () => {
  const { describeAge } = await import("./generation-plans-panel");
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(describeAge("2026-10-07T11:59:40Z", now), "just now");
  assert.equal(describeAge("2026-10-07T11:53:00Z", now), "7 min ago");
  assert.equal(describeAge("2026-10-07T09:00:00Z", now), "3 h ago");
});

test("notices read as short chips with a tone (AC-GP3-01)", async () => {
  const { describeNotice } = await import("./generation-plans-panel");
  assert.deepEqual(describeNotice({ kind: "stage_complete", stageId: "generate", title: "Generate" }), { text: "Generate: complete", tone: "ok" });
  assert.equal(describeNotice({ kind: "budget_100" }).tone, "bad");
  assert.equal(describeNotice({ kind: "review_waiting", count: 3 }).text, "3 waiting for your verdict");
});
